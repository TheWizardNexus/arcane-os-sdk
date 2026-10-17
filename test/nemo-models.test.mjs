import assert from 'node:assert/strict';
import test from '../src/testing.mjs';
import {NEMO_SPEECH_MODELS, prepareNemotronModels, prepareMagpieModels, createNemotronRuntime} from '../src/local-ai/nemotron/index.mjs';

// Synthetic owner records only: these cases start no helper and fetch no model.
function selectedMembers(selection) {
    return [...selection.members, ...(selection.archives ?? []).flatMap(function archiveMembers(archive) {
        return archive.members;
    })];
}

function fakeAssets(selection, {discovery = [], afterPrepare, releaseError} = {}) {
    const calls = {prepare: [], discover: [], openExisting: [], release: [], retain: [], releaseUse: []};
    function projection(id, directory = 'prepared-models') {
        return {id, directory, state: 'ready', members: selectedMembers(selection).map(function nativeMember(member) {
            return {path: member.path, nativePath: `${directory}/${member.path}`};
        })};
    }
    const owner = {
        async prepare(options) {
            calls.prepare.push(options);
            await afterPrepare?.(options);
            return projection(options.id);
        },
        async discover(options) {
            calls.discover.push(options);
            return {directories: [], models: discovery};
        },
        async openExisting(options) {
            calls.openExisting.push(options);
            return projection(options.id, options.directory);
        },
        async release(id) {
            calls.release.push(id);
            if (releaseError) throw releaseError;
        },
        retain(id) {
            calls.retain.push(id);
            return {...projection(id), async release() { calls.releaseUse.push(id); }};
        }
    };
    return {owner, calls, projection};
}

test('NeMo catalog keeps complete ASR, diarization, codec and matching tokenizer sources', function catalog() {
    const {stt, tts} = NEMO_SPEECH_MODELS;
    assert.equal(stt.members.length, 2);
    assert.equal(stt.resourcePaths.model, stt.members[0].path);
    assert.equal(stt.resourcePaths.diarization, stt.members[1].path);
    assert.equal(tts.members.length, 2);
    assert.equal(tts.archives.length, 1);
    const archive = tts.archives[0];
    assert.equal(archive.format, 'tar');
    assert.equal(archive.members.length, 10);
    assert.equal(archive.ranges[0].stopBefore, 'model_weights.ckpt');
    const modelRevision = new URL(tts.members[0].url).pathname.split('/')[4];
    assert.equal(new URL(archive.url).pathname.split('/')[4], modelRevision);
    assert.equal(archive.members.find(function config(member) {
        return member.path === tts.resourcePaths.tokenizerConfig;
    }).member, 'model_config.yaml');
    assert.equal(archive.members.filter(function speakerMap(member) {
        return member.member.endsWith('.speakers.json');
    }).length, 1);
});

test('NeMo preparation delegates original selected sources and owns one release', async function acquisition() {
    for (const [selection, prepare] of [[NEMO_SPEECH_MODELS.stt, prepareNemotronModels], [NEMO_SPEECH_MODELS.tts, prepareMagpieModels]]) {
        const {owner, calls} = fakeAssets(selection);
        const signal = new AbortController().signal;
        function onProgress() {}
        const prepared = await prepare({modelAssets: owner, workingDirectory: 'speech-models', id: selection.modelId,
            signal, onProgress});
        assert.equal(calls.prepare.length, 1);
        assert.deepEqual(calls.prepare[0], {id: selection.modelId, workingDirectory: 'speech-models',
            members: selection.members, archives: selection.archives, signal, onProgress, refresh: false});
        assert.deepEqual(prepared.resourcePaths, selection.resourcePaths);
        assert.equal(prepared.assetProjectionId, selection.modelId);
        const releasing = prepared.release();
        assert.equal(prepared.release(), releasing);
        await releasing;
        assert.deepEqual(calls.release, [selection.modelId]);
    }
});

test('Installed complete selection is borrowed before acquisition while incomplete matches remain unused', async function installed() {
    const selection = NEMO_SPEECH_MODELS.tts;
    const members = selectedMembers(selection).map(function named(member) { return {path: member.path}; });
    const discovery = [
        {catalogId: selection.modelId, complete: false, directory: 'incomplete', members},
        {catalogId: 'another-model', complete: true, directory: 'other', members},
        {catalogId: selection.modelId, complete: true, directory: 'app/models', members}
    ];
    const {owner, calls} = fakeAssets(selection, {discovery});
    const progress = [];
    const prepared = await prepareMagpieModels({modelAssets: owner, directories: ['user/Models', 'app/models'],
        workingDirectory: 'user/Models', id: 'installed', onProgress: async function changed(value) { progress.push(value); }});
    assert.equal(calls.prepare.length, 0);
    assert.deepEqual(calls.discover[0].catalog, [{id: selection.modelId, members: selection.members,
        archives: selection.archives, entryPath: selection.resourcePaths.model}]);
    assert.equal(calls.openExisting[0].directory, 'app/models');
    assert.deepEqual(calls.openExisting[0].members, members);
    assert.deepEqual(progress.map(function phase(value) { return value.phase; }), ['reuse', 'ready']);
    assert.equal(prepared.directory, 'app/models');
    await prepared.release();
    assert.deepEqual(calls.release, ['installed']);
});

test('Missing installed selection acquires and explicit refresh bypasses discovery', async function missingAndRefresh() {
    for (const refresh of [false, true]) {
        const {owner, calls} = fakeAssets(NEMO_SPEECH_MODELS.stt);
        const prepared = await prepareNemotronModels({modelAssets: owner, directories: ['user/Models'],
            workingDirectory: 'user/Models', refresh});
        assert.equal(calls.discover.length, refresh ? 0 : 1);
        assert.equal(calls.prepare.length, 1);
        assert.equal(calls.prepare[0].refresh, refresh);
        await prepared.release();
    }
});

test('Preparation cancellation before work and after acquisition preserves cleanup failures', async function cancellation() {
    const stopped = new Error('Preparation stopped.');
    const before = new AbortController();
    before.abort(stopped);
    const first = fakeAssets(NEMO_SPEECH_MODELS.stt);
    await assert.rejects(prepareNemotronModels({modelAssets: first.owner, signal: before.signal}), function same(error) {
        return error === stopped;
    });
    assert.equal(first.calls.prepare.length, 0);
    const after = new AbortController();
    const cleanup = new Error('Projection cleanup failed.');
    const second = fakeAssets(NEMO_SPEECH_MODELS.stt, {
        afterPrepare: function abortAfterPreparation() { after.abort(stopped); }, releaseError: cleanup
    });
    await assert.rejects(prepareNemotronModels({modelAssets: second.owner, id: 'cancelled', signal: after.signal}), function complete(error) {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [stopped, cleanup]);
        return true;
    });
    assert.deepEqual(second.calls.release, ['cancelled']);
});

test('Installed preparation callback failure releases borrowed ownership', async function callbackFailure() {
    const selection = NEMO_SPEECH_MODELS.stt;
    const failure = new Error('Progress delivery failed.');
    const {owner, calls} = fakeAssets(selection, {discovery: [
        {catalogId: selection.modelId, complete: true, directory: 'installed', members: selection.members}
    ]});
    await assert.rejects(prepareNemotronModels({modelAssets: owner, id: 'borrowed', directories: ['installed'],
        onProgress: function changed(value) { if (value.phase === 'ready') throw failure; }}), function same(error) {
        return error === failure;
    });
    assert.deepEqual(calls.release, ['borrowed']);
    assert.equal(calls.prepare.length, 0);
});

test('Nemotron retains projection before yielding and releases after cancelled runtime preparation joins', async function retainedLoad() {
    const {owner, calls} = fakeAssets(NEMO_SPEECH_MODELS.stt);
    let preparationEntered;
    const entered = new Promise(function retainEntry(resolve) { preparationEntered = resolve; });
    let preparationFinished = false;
    const engine = createNemotronRuntime({modelAssets: owner, gpu: -1,
        prepare: function prepareRuntime({signal}) {
            preparationEntered();
            return new Promise(function pending(resolve, reject) {
                function cancelled() { preparationFinished = true; reject(signal.reason); }
                signal.addEventListener('abort', cancelled, {once: true});
                if (signal.aborted) cancelled();
            });
        }});
    const loading = engine.load({assetProjectionId: 'retained', resourcePaths: NEMO_SPEECH_MODELS.stt.resourcePaths});
    const rejected = assert.rejects(loading, {code: 'NEMOTRON_UNLOADED'});
    assert.deepEqual(calls.retain, ['retained']);
    assert.deepEqual(calls.releaseUse, []);
    await entered;
    await owner.release('retained');
    await engine.unload();
    await rejected;
    assert.equal(preparationFinished, true);
    assert.deepEqual(calls.releaseUse, ['retained']);
    await engine.close();
    assert.deepEqual(calls.releaseUse, ['retained']);
});

test('Nemotron missing projected model releases its retain without starting a helper', async function missingMember() {
    const {owner, calls} = fakeAssets(NEMO_SPEECH_MODELS.stt);
    const engine = createNemotronRuntime({runtime: {helperExecutable: 'never-started'}, modelAssets: owner, gpu: -1});
    await assert.rejects(engine.load({assetProjectionId: 'missing', resourcePaths: {model: 'absent.gguf'}}),
        {code: 'NEMOTRON_RESOURCE_UNAVAILABLE'});
    assert.deepEqual(calls.releaseUse, ['missing']);
    assert.equal(engine.current().state, 'error');
    await engine.close();
});

test('Nemotron direct-path missing-model errors remain explicit', async function directPaths() {
    const engine = createNemotronRuntime({runtime: {helperExecutable: 'never-started'}, gpu: -1});
    await assert.rejects(engine.load(), {code: 'NEMOTRON_MODEL_UNAVAILABLE'});
    await engine.close();
});
