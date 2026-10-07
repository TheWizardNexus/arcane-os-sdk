import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import path from 'node:path';
import test from '../src/testing.mjs';
import {createGitTextSnapshot} from '../src/git-text-snapshot.mjs';

function deferred() {
    let resolve;
    const promise = new Promise(function pending(done) { resolve = done; });
    return {promise, resolve};
}

async function fixture(t, {files, selectPath, fetchGate, failure, bare = true, blobOutput, gitIdentity} = {}) {
    const parent = path.resolve('.arcane/test/git-text-snapshot');
    await mkdir(parent, {recursive: true});
    const cacheDirectory = await mkdtemp(path.join(parent, 'case-'));
    const selectedIdentity = gitIdentity ? {...gitIdentity} : undefined;
    t.after(async function removeOwnedCache() { await rm(cacheDirectory, {recursive: true, force: true}); });
    const state = {
        revision: 'a'.repeat(40), calls: [], fetchStarted: deferred(), events: [],
        files: files ?? [
            {path: 'messages/moon\tcheese\n🧀.md', object: 'b'.repeat(40), content: '\uFEFF  Moon 🧀\r\n\u0000whole story\n\n'},
            {path: 'participants/empty.yaml', object: 'c'.repeat(40), content: ''}
        ]
    };
    async function emitOutput(options, output) {
        assert.equal(options.outputEncoding.stdout, null);
        assert.equal(options.captureOutput.stdout, false);
        assert.equal(options.emitOutputEvents.stdout, false);
        // Every UTF-8 character, metadata header and delimiter crosses chunks.
        for (const value of output) {
            const chunk = Buffer.from([value]);
            try { await options.onOutput({stream: 'stdout', chunk}); }
            catch (cause) {
                const error = new Error('The stdout output callback failed.', {cause});
                error.code = 'ARCANE_OPERATION_FAILED';
                error.details = {stream: 'stdout', chunk};
                throw error;
            }
        }
    }
    async function run(command, args, options = {}) {
        assert.equal(command, 'git');
        state.calls.push({args, options});
        if (selectedIdentity) {
            assert.deepEqual(args.slice(0, 6), ['-c', `user.name=${selectedIdentity.name}`,
                '-c', `user.email=${selectedIdentity.email}`, '-c', `credential.username=${selectedIdentity.username}`]);
            assert.deepEqual(options.env, {GIT_AUTHOR_NAME: selectedIdentity.name, GIT_COMMITTER_NAME: selectedIdentity.name,
                GIT_AUTHOR_EMAIL: selectedIdentity.email, GIT_COMMITTER_EMAIL: selectedIdentity.email});
            args = args.slice(6);
        }
        let stdout = '';
        if (args[0] === 'init') {
            assert.deepEqual(args, ['init', '--bare', cacheDirectory]);
        } else {
            assert.deepEqual(args.slice(0, 2), ['--git-dir', cacheDirectory]);
            const operation = args[2];
            if (operation === 'rev-parse') stdout = args[3] === '--is-bare-repository' ? `${bare}\n` : `${state.revision}\n`;
            else if (operation === 'fetch') {
                assert.deepEqual(args.slice(2), ['fetch', '--no-tags', '--no-write-fetch-head', '--', 'example-remote', '+main:refs/arcane/text-snapshot']);
                assert.equal(options.signal, undefined);
                state.fetchStarted.resolve();
                if (fetchGate) await fetchGate.promise;
                if (failure?.current) throw failure.current;
            } else if (operation === 'ls-tree') {
                assert.deepEqual(args.slice(2), ['ls-tree', '-r', '-z', '--full-tree', state.revision]);
                const tree = Buffer.concat(state.files.map(function record(file) {
                    return Buffer.concat([Buffer.from(`100644 ${file.type ?? 'blob'} ${file.object}\t`),
                        file.pathBuffer ?? Buffer.from(file.path), Buffer.from([0])]);
                }));
                await emitOutput(options, tree);
            } else if (operation === 'cat-file') {
                const requested = [];
                for await (const line of options.input) requested.push(line.trim());
                const output = Buffer.concat(requested.map(function blob(object) {
                    const file = state.files.find(function selected(value) { return value.object === object; });
                    const body = file.buffer ?? Buffer.from(file.content);
                    // Length is Git protocol framing only, never an assertion
                    // about allowed product content or a fixture admission gate.
                    return Buffer.concat([Buffer.from(`${object} blob ${body.length}\n`), body, Buffer.from('\n')]);
                }));
                await emitOutput(options, blobOutput ?? output);
            } else assert.fail(`Unexpected Git operation ${operation}`);
        }
        return {code: 0, stdout, stderr: ''};
    }
    const owner = createGitTextSnapshot({
        cacheDirectory, remote: 'example-remote', ref: 'main', gitIdentity,
        selectPath: selectPath ?? function selectAll() { return true; },
        run, onEvent: function observe(event) { state.events.push(event); }
    });
    t.after(async function drainOwner() {
        if (state.expectedCloseError) {
            await assert.rejects(owner.close(), function expected(error) { return error === state.expectedCloseError; });
        } else await owner.close();
    });
    return {owner, state};
}

test('Git snapshot preserves complete ordered text, paths, BOM, CRLF, NUL and split UTF-8', async function completeText(t) {
    const {owner, state} = await fixture(t);
    const result = await owner.refresh();
    assert.deepEqual(result, {revision: state.revision, files: state.files.map(function text(file) {
        return {path: file.path, content: file.content};
    })});
    assert.equal(state.calls.filter(function batch(call) { return call.args[2] === 'cat-file'; }).length, 1);
    assert.equal(state.calls.some(function checkout(call) { return call.args.includes('checkout'); }), false);
});

test('snapshot remoteBase captures the local locator before cwd and caller changes', async function snapshotRemoteBase(t) {
    const parent = path.resolve('.arcane/test/git-text-snapshot');
    await mkdir(parent, {recursive: true});
    const root = await mkdtemp(path.join(parent, 'remote-base-'));
    t.after(async function removeOwnedCache() { await rm(root, {recursive: true, force: true}); });
    const cacheDirectory = path.join(root, 'cache');
    const remote = path.join('..', 'Moon # % 🧀', 'wire.git');
    const remoteBase = path.join('catalog', 'connections');
    const calls = [];
    let failure;
    const configuration = {cacheDirectory, remote, remoteBase, ref: 'refs/heads/main',
        selectPath: function selectAll() { return true; },
        run: async function fakeGit(command, args) {
            assert.equal(command, 'git');
            calls.push(args);
            if (args[2] === 'fetch' && failure) throw failure;
            let stdout = '';
            if (args[2] === 'rev-parse') stdout = args[3] === '--is-bare-repository' ? 'true\n' : 'selected-revision\n';
            return {code: 0, stdout, stderr: 'Complete diagnostic.'};
        }};
    const previousDirectory = process.cwd();
    let owner;
    try {
        process.chdir(root);
        owner = createGitTextSnapshot(configuration);
    } finally {
        process.chdir(previousDirectory);
    }
    t.after(async function drainOwner() { await owner.close(); });
    configuration.remote = 'later-remote';
    configuration.remoteBase = 'later-base';
    configuration.ref = 'refs/heads/later';
    assert.equal(calls.length, 0);
    assert.deepEqual(await owner.refresh(), {revision: 'selected-revision', files: []});
    assert.deepEqual(await owner.refresh(), {revision: 'selected-revision', files: []});
    assert.deepEqual(calls.filter(function fetched(args) { return args[2] === 'fetch'; }), [
        ['--git-dir', cacheDirectory, 'fetch', '--no-tags', '--no-write-fetch-head', '--',
            path.resolve(root, remoteBase, remote), '+refs/heads/main:refs/arcane/text-snapshot'],
        ['--git-dir', cacheDirectory, 'fetch', '--no-tags', '--no-write-fetch-head', '--',
            path.resolve(root, remoteBase, remote), '+refs/heads/main:refs/arcane/text-snapshot']
    ]);
    assert.equal(calls.filter(function listed(args) { return args[2] === 'ls-tree'; }).length, 1);
    failure = new Error('Complete local repository fetch failure.');
    failure.details = {code: 128, stdout: 'Complete stdout.\n', stderr: 'Complete stderr.\n'};
    await assert.rejects(owner.refresh(), function actualFailure(error) { return error === failure; });
});

test('snapshot identity covers bare initialization and fetch while retaining shared acquisition', async function snapshotIdentity(t) {
    const gate = deferred();
    const gitIdentity = {name: 'Moon Dispatcher', email: 'moon@example.invalid', username: 'moon-account'};
    const {owner, state} = await fixture(t, {fetchGate: gate, gitIdentity});
    gitIdentity.name = 'Later connection';
    gitIdentity.username = 'later-account';
    assert.equal(state.calls.length, 0);
    const controller = new AbortController();
    const first = owner.refresh({signal: controller.signal});
    const second = owner.refresh();
    await state.fetchStarted.promise;
    controller.abort('This caller left.');
    await assert.rejects(first, {code: 'ARCANE_CANCELLED'});
    gate.resolve();
    const result = await second;
    assert.deepEqual(result.files, state.files.map(function complete(file) { return {path: file.path, content: file.content}; }));
    assert.equal(state.calls[0].args[6], 'init');
    assert.equal(state.calls.filter(function fetch(call) { return call.args[8] === 'fetch'; }).length, 1);
    assert.ok(state.calls.every(function sharedLifetime(call) { return call.options.signal === undefined; }));
});

test('concurrent refresh shares one fetch and one cancelled caller does not stop another', async function sharedRefresh(t) {
    const gate = deferred();
    const {owner, state} = await fixture(t, {fetchGate: gate});
    const controller = new AbortController();
    const first = owner.refresh({signal: controller.signal});
    const second = owner.refresh();
    await state.fetchStarted.promise;
    controller.abort('First caller left.');
    await assert.rejects(first, {code: 'ARCANE_CANCELLED'});
    gate.resolve();
    assert.equal((await second).files[0].content, state.files[0].content);
    assert.equal(state.calls.filter(function fetch(call) { return call.args[2] === 'fetch'; }).length, 1);
});

test('unchanged revisions reuse retrieval without exposing mutable cache records', async function unchangedRevision(t) {
    const {owner, state} = await fixture(t);
    const first = await owner.refresh();
    first.files[0].content = 'caller edit';
    first.files.push({path: 'invented', content: 'caller entry'});
    const second = await owner.refresh();
    assert.equal(second.files.length, state.files.length);
    assert.equal(second.files[0].content, state.files[0].content);
    assert.equal(state.calls.filter(function tree(call) { return call.args[2] === 'ls-tree'; }).length, 1);
    state.revision = 'd'.repeat(40);
    state.files[0].content = 'Entire new revision\r\n';
    const third = await owner.refresh();
    assert.equal(third.revision, state.revision);
    assert.equal(third.files[0].content, state.files[0].content);
    assert.equal(state.calls.filter(function tree(call) { return call.args[2] === 'ls-tree'; }).length, 2);
});

test('application selector receives full paths and unselected invalid content is never retrieved', async function appSelection(t) {
    const observed = [];
    const files = [
        {path: 'messages/whole.md', object: 'b'.repeat(40), content: 'Complete selected text'},
        {path: 'binary/image', object: 'c'.repeat(40), buffer: Buffer.from([255])}
    ];
    const {owner} = await fixture(t, {files, selectPath: function select(filename) {
        observed.push(filename);
        return filename.startsWith('messages/');
    }});
    assert.deepEqual((await owner.refresh()).files, [{path: files[0].path, content: files[0].content}]);
    assert.deepEqual(observed, files.map(function filename(file) { return file.path; }));
});

test('close stops acceptance and drains accepted refresh even after all callers cancel', async function draining(t) {
    const gate = deferred();
    const {owner, state} = await fixture(t, {fetchGate: gate});
    const controller = new AbortController();
    const request = owner.refresh({signal: controller.signal});
    await state.fetchStarted.promise;
    controller.abort();
    await assert.rejects(request, {code: 'ARCANE_CANCELLED'});
    const closed = owner.close();
    assert.equal(owner.drain(), closed);
    assert.equal(owner.dispose(), closed);
    await assert.rejects(owner.refresh(), {code: 'CORE_CLOSING'});
    let settled = false;
    closed.then(function drained() { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);
    gate.resolve();
    await closed;
    assert.equal(settled, true);
    assert.equal(state.events.at(-1).type, 'git.snapshot.completed');
});

test('fetch failure stays observable instead of returning retained stale success', async function failedRefresh(t) {
    const failure = {current: null};
    const {owner, state} = await fixture(t, {failure});
    await owner.refresh();
    failure.current = new Error('Complete actual Git fetch failure');
    await assert.rejects(owner.refresh(), function original(error) { return error === failure.current; });
    assert.equal(state.events.at(-1).data.error, failure.current);
    failure.current = null;
    assert.equal((await owner.refresh()).revision, state.revision);
});

test('invalid UTF-8 blob or path and selected gitlinks report representability rather than replacement', async function unreadableText(t) {
    for (const file of [
        {path: 'invalid.md', object: 'b'.repeat(40), buffer: Buffer.from([255])},
        {path: 'incomplete.md', object: 'b'.repeat(40), buffer: Buffer.from([0xf0, 0x9f])},
        {path: 'invalid-path', pathBuffer: Buffer.from([255]), object: 'b'.repeat(40), content: 'text'},
        {path: 'submodule', object: 'b'.repeat(40), type: 'commit', content: ''}
    ]) {
        const {owner} = await fixture(t, {files: [file]});
        await assert.rejects(owner.refresh(), {code: 'ARCANE_GIT_SNAPSHOT_NOT_TEXT'});
    }
});

test('pre-aborted refresh performs no filesystem or process work', async function preAborted(t) {
    const {owner, state} = await fixture(t);
    const controller = new AbortController();
    controller.abort('Do not begin');
    await assert.rejects(owner.refresh({signal: controller.signal}), {code: 'ARCANE_CANCELLED'});
    assert.equal(state.calls.length, 0);
});

test('empty selection is a complete empty snapshot without a blob process', async function emptySelection(t) {
    const {owner, state} = await fixture(t, {selectPath: function selectNone() { return false; }});
    assert.deepEqual(await owner.refresh(), {revision: state.revision, files: []});
    assert.equal(state.calls.some(function blob(call) { return call.args[2] === 'cat-file'; }), false);
});

test('incomplete batch output never becomes a partial successful snapshot', async function incompleteBatch(t) {
    const {owner} = await fixture(t, {blobOutput: Buffer.from(`${'b'.repeat(40)} blob 8\npart`)});
    await assert.rejects(owner.refresh(), {code: 'ARCANE_GIT_SNAPSHOT_PROTOCOL'});
});

test('a non-bare repository is never used for snapshot fetches', async function wrongCacheRole(t) {
    const {owner, state} = await fixture(t, {bare: false});
    await assert.rejects(owner.refresh(), {code: 'ARCANE_GIT_SNAPSHOT_CACHE_INVALID'});
    assert.equal(state.calls.some(function fetch(call) { return call.args[2] === 'fetch'; }), false);
});

test('close reports an accepted refresh failure after caller cancellation', async function failedDrain(t) {
    const fetchGate = deferred();
    const failure = {current: new Error('Fetch failed while service was closing.')};
    const {owner, state} = await fixture(t, {fetchGate, failure});
    const controller = new AbortController();
    const request = owner.refresh({signal: controller.signal});
    await state.fetchStarted.promise;
    controller.abort();
    await assert.rejects(request, {code: 'ARCANE_CANCELLED'});
    state.expectedCloseError = failure.current;
    const closed = owner.close();
    const observed = assert.rejects(closed, function original(error) { return error === failure.current; });
    fetchGate.resolve();
    await observed;
});
