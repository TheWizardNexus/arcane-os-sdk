import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from '../src/testing.mjs';
import {createNativeDecisionModel} from '../src/local-ai/decisions.mjs';
import {createDecisionTokenizer} from '../src/local-ai/decision-tokenizer.mjs';
import {createNativeDecisionService} from '../src/core/services/decisions.mjs';
import {decodeTensorMap} from '../browser-runtime/ai/onnx-tensors.mjs';

// These fixtures use the real approved tokenizer worker with synthetic BPE
// files and a fake public ONNX owner. They download and execute no model.
const originalState = '  Moon charter: 雪 🐙\r\nKeep  every paragraph and [MASK].\n'.repeat(40);
const rows = [
    {state: originalState, question: '  Choose the moon chef?\n', options: ['raccoon', 'octopus', '  lunar llama  ']},
    {state: originalState, question: 'Score the cheese storm?', options: ['low', 'high'], type: 'score'},
    {state: originalState, question: 'Keep the entire charter?', options: ['false', 'true'], type: 'noul'}
];

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise(function retainSettlement(onResolve, onReject) {
        resolve = onResolve;
        reject = onReject;
    });
    return {promise, resolve, reject};
}

function graphOutputs() {
    return {
        logits: {type: 'float32', dims: [3, 3], data: new Float32Array([0, 1, 2, 0, 1, -99, 0, 1, -88])},
        act_logits: {type: 'float32', dims: [3, 2], data: new Float32Array([1, 0, 0, 1, 2, 0])},
        extra: {type: 'int64', dims: [2, 2], data: new BigInt64Array([91n, -92n, 93n, 9007199254740993n])},
        future_output: {type: 'float64', dims: [3], data: new Float64Array([NaN, Infinity, -Infinity])}
    };
}

async function fixture(t, {invalidTokenizer = false} = {}) {
    const parent = fileURLToPath(new URL('../.arcane/task-artifacts/', import.meta.url));
    await mkdir(parent, {recursive: true});
    const root = await mkdtemp(path.join(parent, 'native-decisions-'));
    const owners = [];
    const gates = [];
    t.after(async function releaseSyntheticFiles() {
        for (const gate of gates) gate.resolve();
        const results = await Promise.allSettled(owners.map(function closeOwner(owner) {
            return owner.dispose ? owner.dispose() : owner.close();
        }));
        const failures = results.filter(function failed(result) { return result.status === 'rejected'; })
            .map(function actualFailure(result) { return result.reason; });
        if (failures.length) throw new AggregateError(failures, 'Synthetic decision owners did not finish releasing their files.');
        // root is the exact task-owned child returned by mkdtemp above.
        await rm(root, {recursive: true, force: true});
    });
    const vocabulary = {'[PAD]': 0, '[CLS]': 1, '[SEP]': 2, '[MASK]': 3, '[UNK]': 4};
    for (const text of ['choice score noul question: ', ...rows.flatMap(function completeFields(row) {
        return [row.state, row.question, ...row.options];
    })]) {
        for (const character of text) {
            if (!Object.hasOwn(vocabulary, character)) vocabulary[character] = Object.keys(vocabulary).length;
        }
    }
    const tokenizer = {
        version: '1.0', added_tokens: [], normalizer: null, pre_tokenizer: null,
        post_processor: null, decoder: null,
        model: {type: 'BPE', vocab: vocabulary, merges: [], unk_token: '[UNK]'}
    };
    const paths = {
        model: path.join(root, 'onnx', 'model.onnx'),
        tokenizer: path.join(root, 'tokenizer.json'),
        tokenizerConfig: path.join(root, 'tokenizer_config.json')
    };
    await mkdir(path.dirname(paths.model));
    await Promise.all([
        writeFile(paths.tokenizer, invalidTokenizer ? '{' : JSON.stringify(tokenizer)),
        writeFile(paths.tokenizerConfig, JSON.stringify({remove_space: false, clean_up_tokenization_spaces: false})),
        writeFile(paths.model, 'Synthetic graph path; never passed to a real inference engine.'),
        writeFile(path.join(root, 'onnx', 'model.onnx_data'), 'Synthetic external graph resource.')
    ]);
    function own(owner) { owners.push(owner); return owner; }
    function gate() { const value = deferred(); gates.push(value); return value; }
    return {root, paths, vocabulary, own, gate};
}

function pendingOperation(task, signal) {
    return new Promise(function awaitOwnedOperation(resolve, reject) {
        function abort() { reject(signal.reason); }
        signal.addEventListener('abort', abort, {once: true});
        if (signal.aborted) abort();
        task.then(resolve, reject).finally(function detachAbort() { signal.removeEventListener('abort', abort); });
    });
}

function fakeONNX({outputs = graphOutputs(), loadError, unloadError, runError, runGate, exitGate, beforeLoad} = {}) {
    const sessions = new Map();
    const listeners = new Set();
    const calls = {load: [], run: [], unload: []};
    const runStarted = deferred();
    const unloadStarted = deferred();
    function current() { return {closed: false, sessions: [...sessions.values()]}; }
    function publish() { for (const listener of listeners) listener(current()); }
    function failWorker(error) {
        const session = sessions.get(calls.load[0].id);
        session.stopping = true;
        session.state = 'error';
        session.error = error;
        publish();
    }
    const owner = {
        current,
        subscribe(listener) {
            listeners.add(listener);
            listener(current());
            return function stopStateObservation() { listeners.delete(listener); };
        },
        async load(options) {
            beforeLoad?.(options);
            calls.load.push(options);
            options.signal.throwIfAborted();
            if (loadError) throw loadError;
            const session = {
                id: options.id, model: options.model, loaded: true, state: 'ready', error: null, stopping: false, exited: false,
                execution: {requestedTarget: options.executionTarget, observedTarget: null}
            };
            sessions.set(options.id, session);
            publish();
            return session;
        },
        async run(options) {
            calls.run.push(options);
            const error = calls.run.length === 1 ? runError : undefined;
            options.signal.throwIfAborted();
            runStarted.resolve(options);
            if (runGate) await pendingOperation(runGate.promise, options.signal);
            options.signal.throwIfAborted();
            const session = sessions.get(options.id);
            if (error) {
                session.state = 'error';
                session.error = error;
                publish();
                throw error;
            }
            if (session.state === 'error') {
                session.state = 'ready';
                session.error = null;
                publish();
            }
            return outputs;
        },
        async unload(options) {
            calls.unload.push(options);
            const session = sessions.get(options.id);
            assert.ok(session, 'Only an actually created session may be unloaded.');
            session.stopping = true;
            session.state = 'unloading';
            publish();
            unloadStarted.resolve(options);
            if (exitGate) await exitGate.promise;
            session.exited = true;
            session.loaded = false;
            session.state = unloadError ? 'error' : 'unloaded';
            session.error = unloadError ?? null;
            publish();
            if (unloadError) throw unloadError;
            return session;
        }
    };
    return {owner, calls, outputs, runStarted, unloadStarted, failWorker};
}

function fakeAssets(files, projections = []) {
    const records = new Map(projections.map(function readyProjection(projection) {
        return [projection.id, {
            state: 'ready', preparationOwned: true, retained: false, uses: 0,
            members: ['onnx/model.onnx', 'onnx/model.onnx_data', 'tokenizer.json', 'tokenizer_config.json'].map(function member(pathname) {
                return {path: pathname, nativePath: path.join(files.root, pathname)};
            }), ...projection
        }];
    }));
    const calls = {prepare: [], retain: [], release: [], releaseRetain: []};
    const owner = {
        async prepare(options) {
            calls.prepare.push(options);
            options.signal.throwIfAborted();
            const record = {
                id: options.id, state: 'ready', preparationOwned: true, retained: false, uses: 0,
                members: options.members.map(function preparedMember(member) {
                    return {...member, nativePath: path.join(files.root, member.path)};
                })
            };
            records.set(options.id, record);
            return record;
        },
        retain(id) {
            calls.retain.push(id);
            const record = records.get(id);
            if (!record || record.state === 'released') throw Object.assign(new Error('The requested projection is unavailable.'), {code: 'MODEL_ASSET_PROJECTION_UNAVAILABLE'});
            if (record.state !== 'ready') throw Object.assign(new Error('The complete projection is not ready.'), {code: 'MODEL_ASSET_PROJECTION_NOT_READY'});
            record.uses += 1;
            record.retained = true;
            let released;
            return {id, directory: files.root, members: record.members, release() {
                if (released) return released;
                calls.releaseRetain.push(id);
                record.uses -= 1;
                record.retained = record.uses > 0;
                if (!record.preparationOwned && !record.retained) record.state = 'released';
                released = Promise.resolve();
                return released;
            }};
        },
        release(id) {
            calls.release.push(id);
            const record = records.get(id);
            record.preparationOwned = false;
            if (!record.retained) record.state = 'released';
            return Promise.resolve();
        }
    };
    return {owner, records, calls};
}

function expectedInputs(vocabulary) {
    function tokens(text) { return Array.from(text, function token(character) { return BigInt(vocabulary[character]); }); }
    const complete = rows.map(function completeRow(row) {
        const values = [1n, ...tokens(`${row.type ?? 'choice'} question: ${row.question}`), 2n];
        const markers = [];
        for (const option of row.options) {
            markers.push(BigInt(values.length));
            values.push(3n, ...tokens(` ${option}`));
        }
        values.push(2n, ...tokens(row.state), 2n);
        return {values, markers};
    });
    const width = Math.max(...complete.map(function sequence(row) { return row.values.length; }));
    const input = [];
    const attention = [];
    const markers = [];
    const markerMask = [];
    for (const row of complete) {
        input.push(...row.values, ...Array(width - row.values.length).fill(0n));
        attention.push(...Array(row.values.length).fill(1n), ...Array(width - row.values.length).fill(0n));
        markers.push(...row.markers, ...Array(3 - row.markers.length).fill(0n));
        markerMask.push(...Array(row.markers.length).fill(1), ...Array(3 - row.markers.length).fill(0));
    }
    return {
        input_ids: {type: 'int64', dims: [3, width], data: new BigInt64Array(input)},
        attention_mask: {type: 'int64', dims: [3, width], data: new BigInt64Array(attention)},
        marker_pos: {type: 'int64', dims: [3, 3], data: new BigInt64Array(markers)},
        marker_mask: {type: 'bool', dims: [3, 3], data: new Uint8Array(markerMask)},
        qtype: {type: 'int64', dims: [3], data: new BigInt64Array([0n, 1n, 2n])}
    };
}

test('native FP32 decisions preserve complete input framing, typed decisions and every graph output', async function completeNativeDecisions(t) {
    const files = await fixture(t);
    const native = fakeONNX();
    const sessionOptions = {graphOptimizationLevel: 'all'};
    const model = files.own(createNativeDecisionModel({onnx: native.owner, paths: files.paths, sessionOptions}));
    const snapshots = [];
    const stop = model.subscribe(function observed(snapshot) { snapshots.push(snapshot); });
    assert.equal(model.current().dtype, 'fp32');
    assert.equal(model.current().state, 'unloaded');
    assert.equal(native.calls.load.length, 0);
    assert.equal(snapshots[0].loaded, false);
    await model.load();
    assert.equal(model.current().loaded, true);
    assert.equal(native.calls.load.length, 1);
    assert.equal(native.calls.load[0].model, files.paths.model);
    assert.equal(native.calls.load[0].executionPreference, 'gpu');
    assert.equal(native.calls.load[0].executionTarget, undefined);
    assert.equal(native.calls.load[0].sessionOptions, sessionOptions);
    const originalRows = structuredClone(rows);
    const runOptions = {tag: 'complete moon charter'};
    const result = await model.evaluate(rows, {runOptions});
    assert.deepEqual(native.calls.run[0].feeds, expectedInputs(files.vocabulary));
    assert.equal(native.calls.run[0].runOptions, runOptions);
    assert.equal(native.calls.run[0].id, native.calls.load[0].id);
    assert.equal(result.outputs, native.outputs);
    assert.deepEqual(Object.keys(result.outputs), ['logits', 'act_logits', 'extra', 'future_output']);
    assert.deepEqual(rows, originalRows);
    for (const [index, decision] of result.decisions.entries()) {
        assert.equal(decision.row, rows[index]);
        assert.equal(decision.row.state, originalState);
    }
    assert.equal(result.decisions[0].answerIndex, 2);
    assert.equal(result.decisions[0].value, '  lunar llama  ');
    assert.deepEqual(result.decisions[0].logits, [0, 1, 2]);
    assert.deepEqual(result.decisions[1].logits, [0, 1]);
    assert.deepEqual(result.decisions[2].logits, [0, 1]);
    const probability = 1 / (1 + Math.exp(-1));
    assert.equal(result.decisions[1].value, probability);
    assert.equal(result.decisions[2].value, probability);
    assert.equal(result.decisions[2].probabilities[1], probability);
    assert.deepEqual(result.decisions[0].actionLogits, [1, 0]);
    assert.equal(result.decisions[0].actProbability, probability);
    assert.deepEqual(await model.classify([]), {decisions: [], outputs: {}});
    assert.equal(native.calls.run.length, 1);
    await model.unload();
    assert.equal(model.current().loaded, false);
    assert.equal(model.current().state, 'unloaded');
    assert.equal(native.calls.unload[0].id, native.calls.load[0].id);
    stop();
});

test('Core decisions compose the same native owners and encode only the tensor transport boundary', async function nativeServiceComposition(t) {
    const files = await fixture(t);
    const native = fakeONNX();
    const assets = fakeAssets(files);
    const lookups = [];
    const emissions = [];
    let nativeOwnerSelections = 0;
    const service = files.own(createNativeDecisionService({workingDirectory: 'model-working'}, {appRoot: files.root}));
    service.start({
        getService(name) {
            lookups.push(name);
            if (name === 'local-ai') return Promise.resolve({getONNXRuntime() { nativeOwnerSelections += 1; return native.owner; }});
            assert.equal(name, 'model-assets');
            return Promise.resolve(assets.owner);
        },
        emit(event, data) { emissions.push({event, data}); }
    });
    assert.deepEqual(lookups, []);
    assert.equal(native.calls.load.length, 0);
    assert.equal(assets.calls.prepare.length, 0);
    await Promise.all([service.load(), service.load()]);
    assert.deepEqual(lookups, ['local-ai', 'model-assets']);
    assert.equal(nativeOwnerSelections, 1);
    assert.equal(native.calls.load.length, 1);
    assert.deepEqual(assets.calls.prepare[0].members.map(function memberPath(member) { return member.path; }),
        ['onnx/model.onnx', 'onnx/model.onnx_data', 'tokenizer.json', 'tokenizer_config.json']);
    for (const member of assets.calls.prepare[0].members) {
        assert.equal(member.url, `https://huggingface.co/onnx-community/laya-typed-decisions-ONNX/resolve/main/${member.path}`);
    }
    const result = await service.methods['decisions.evaluate']({rows}, {signal: t.signal});
    assert.deepEqual(decodeTensorMap(result.outputs), native.outputs);
    assert.equal(result.decisions[0].row, rows[0]);
    assert.equal(result.decisions[0].row.state, originalState);
    assert.ok(emissions.some(function ready(snapshot) { return snapshot.event === 'decisions.state' && snapshot.data.loaded; }));
    await service.unload();
    assert.equal(assets.calls.releaseRetain.length, 1);
    assert.equal(service.current().loaded, false);
});

test('immediate Core load then unload cancels before dependency lookup without a release cycle', async function immediateLoadUnload(t) {
    const service = createNativeDecisionService();
    t.after(function releaseService() { return service.dispose(); });
    const lookups = [];
    service.start({getService(name) { lookups.push(name); throw new Error('A cancelled activation must not request dependencies.'); }, emit() {}});
    const loading = service.load();
    const rejected = assert.rejects(loading, {code: 'ARCANE_AI_REQUEST_ABORTED'});
    const unloading = service.unload();
    await Promise.all([rejected, unloading]);
    assert.deepEqual(lookups, []);
    assert.equal(service.current().loaded, false);
    assert.equal(service.current().busy, false);
});

for (const route of ['direct', 'Core']) {
    const resourcePaths = {model: 'onnx/model.onnx', tokenizer: 'tokenizer.json', tokenizerConfig: 'tokenizer_config.json'};

    function projectedOwner(files, native, assets, configuration = {}) {
        const decisions = files.own(route === 'direct'
            ? createNativeDecisionModel({...configuration, onnx: native.owner, modelAssets: assets.owner})
            : createNativeDecisionService(configuration, {appRoot: files.root}));
        if (route === 'Core') decisions.start({
            getService(name) {
                assert.ok(['local-ai', 'model-assets'].includes(name));
                return name === 'local-ai' ? {getONNXRuntime() { return native.owner; }} : assets.owner;
            },
            emit() {}
        });
        return decisions;
    }

    function loadProjection(decisions, options = {}, signal) {
        return route === 'Core'
            ? decisions.methods['decisions.load'](options, {signal})
            : decisions.load({...options, signal});
    }

    test(`${route} retained projections preserve all 160 rows and graph outputs without preparing upstream files`, async function completeProjectedBatch(t) {
        const files = await fixture(t);
        const completeRows = Array.from({length: 160}, function originalRow(_, index) {
            return {...rows[index % rows.length], applicationRecord: {index, note: '  Entire moon record.\r\n雪 🐙  '}};
        });
        const originalRows = structuredClone(completeRows);
        const outputs = {
            ...graphOutputs(),
            logits: {type: 'float32', dims: [160, 3], data: new Float32Array(completeRows.flatMap(function rowScores() { return [0, 1, 2]; }))},
            act_logits: {type: 'float32', dims: [160, 2], data: new Float32Array(completeRows.flatMap(function actionScores() { return [1, 0]; }))}
        };
        const assets = fakeAssets(files, [{id: 'saved-moon'}]);
        const native = fakeONNX({outputs, beforeLoad() { assert.ok(assets.records.get('saved-moon').uses > 0); }});
        const sessionOptions = {graphOptimizationLevel: 'all'};
        const executionTarget = {deviceId: 'cpu'};
        const decisions = projectedOwner(files, native, assets, {sessionOptions, paths: files.paths, assetProjectionId: 'saved-moon', resourcePaths});
        assert.deepEqual(assets.calls, {prepare: [], retain: [], release: [], releaseRetain: []});
        assert.equal(native.calls.load.length, 0);
        await loadProjection(decisions, {executionTarget}, t.signal);
        assert.equal(native.calls.load[0].model, files.paths.model);
        assert.equal(native.calls.load[0].sessionOptions, sessionOptions);
        assert.equal(native.calls.load[0].executionTarget, executionTarget);
        assert.equal(assets.calls.prepare.length, 0);
        assert.equal(assets.calls.release.length, 0, 'The decision owner never releases caller preparation ownership.');
        assert.equal(assets.records.get('saved-moon').uses, 1);
        assert.deepEqual(assets.records.get('saved-moon').members.map(function member(value) { return value.path; }),
            ['onnx/model.onnx', 'onnx/model.onnx_data', 'tokenizer.json', 'tokenizer_config.json']);
        await assets.owner.release('saved-moon');
        const runOptions = {tag: 'Every moon decision'};
        const result = route === 'Core'
            ? await decisions.methods['decisions.evaluate']({rows: completeRows, runOptions}, {signal: t.signal})
            : await decisions.evaluate(completeRows, {signal: t.signal, runOptions});
        assert.equal(native.calls.run.length, 1);
        assert.equal(native.calls.run[0].feeds.input_ids.dims[0], 160);
        assert.equal(native.calls.run[0].feeds.qtype.data.length, 160);
        assert.equal(native.calls.run[0].runOptions, runOptions);
        assert.equal(result.decisions.length, 160);
        for (const [index, decision] of result.decisions.entries()) {
            assert.equal(decision.row, completeRows[index]);
            assert.deepEqual(decision.row, originalRows[index]);
        }
        assert.deepEqual(completeRows, originalRows);
        assert.deepEqual(route === 'Core' ? decodeTensorMap(result.outputs) : result.outputs, outputs);
        await loadProjection(decisions, {assetProjectionId: undefined, resourcePaths: undefined, executionTarget: undefined});
        assert.equal(native.calls.load.length, 1);
        await decisions.unload();
        assert.equal(assets.records.get('saved-moon').uses, 0);
        assert.equal(assets.records.get('saved-moon').state, 'released');
    });

    test(`${route} projection and resource changes replace equal-target activations while equal selections coalesce`, async function projectedSelection(t) {
        const files = await fixture(t);
        const assets = fakeAssets(files, [{id: 'first-moon'}, {id: 'second-moon'}]);
        assets.records.get('second-moon').members.push({path: 'alternate/model.onnx', nativePath: files.paths.model});
        const native = fakeONNX();
        const decisions = projectedOwner(files, native, assets, {paths: files.paths});
        await Promise.all([
            loadProjection(decisions, {assetProjectionId: 'first-moon', resourcePaths}),
            loadProjection(decisions, {assetProjectionId: 'first-moon', resourcePaths: {...resourcePaths}})
        ]);
        assert.equal(native.calls.load.length, 1);
        await loadProjection(decisions, {assetProjectionId: 'second-moon'});
        assert.equal(native.calls.load.length, 2);
        assert.equal(assets.records.get('first-moon').uses, 0);
        assert.equal(assets.records.get('first-moon').preparationOwned, true);
        await loadProjection(decisions, {resourcePaths: {...resourcePaths, model: 'alternate/model.onnx'}});
        assert.equal(native.calls.load.length, 3);
        assert.equal(assets.calls.prepare.length, 0);
        await loadProjection(decisions, {assetProjectionId: null});
        assert.equal(native.calls.load.length, 4);
        assert.equal(native.calls.load[3].model, files.paths.model);
        assert.equal(assets.records.get('second-moon').uses, 0);
        assert.equal(assets.calls.prepare.length, 0, 'Null restores the configured caller-owned paths.');
        await loadProjection(decisions);
        assert.equal(native.calls.load.length, 4);
    });

    test(`${route} target replacement retains the incoming projection before predecessor exit and drops superseded pending uses`, async function retainedReplacement(t) {
        const files = await fixture(t);
        const exitGate = files.gate();
        const assets = fakeAssets(files, [{id: 'shared-moon'}]);
        const native = fakeONNX({exitGate, beforeLoad() {
            assert.equal(assets.records.get('shared-moon').state, 'ready');
            for (const session of native.owner.current().sessions) assert.equal(session.exited, true);
        }});
        const decisions = projectedOwner(files, native, assets);
        await loadProjection(decisions, {assetProjectionId: 'shared-moon', resourcePaths, executionTarget: {deviceId: 'first-moon-device'}});
        await assets.owner.release('shared-moon');
        const intermediate = loadProjection(decisions, {executionTarget: {deviceId: 'intermediate-moon-device'}});
        const rejected = assert.rejects(intermediate, {code: 'ARCANE_AI_REQUEST_ABORTED'});
        await native.unloadStarted.promise;
        assert.ok(assets.records.get('shared-moon').uses >= 2);
        const latestTarget = {deviceId: 'last-moon-device'};
        const latest = loadProjection(decisions, {executionTarget: latestTarget});
        assert.equal(native.calls.load.length, 1);
        exitGate.resolve();
        await Promise.all([rejected, latest]);
        assert.equal(native.calls.load.length, 2);
        assert.equal(native.calls.load[1].executionTarget, latestTarget);
        assert.equal(assets.records.get('shared-moon').uses, 1);
        assert.equal(assets.records.get('shared-moon').state, 'ready');
        assert.equal(assets.calls.prepare.length, 0);
        await decisions.unload();
        assert.equal(assets.records.get('shared-moon').uses, 0);
        assert.equal(assets.records.get('shared-moon').state, 'released');
    });

    test(`${route} supplied projection failures surface without upstream preparation or native startup`, async function unavailableProjection(t) {
        for (const selection of [
            {id: 'missing-moon', code: 'MODEL_ASSET_PROJECTION_UNAVAILABLE'},
            {id: 'unfinished-moon', state: 'preparing', code: 'MODEL_ASSET_PROJECTION_NOT_READY'},
            {id: 'missing-tokenizer', mapping: {...resourcePaths, tokenizer: 'absent/tokenizer.json'}, code: 'ARCANE_DECISION_RESOURCE_UNAVAILABLE'}
        ]) {
            const files = await fixture(t);
            const native = fakeONNX();
            const assets = fakeAssets(files, selection.id === 'missing-moon' ? [] : [{id: selection.id, state: selection.state ?? 'ready'}]);
            const decisions = projectedOwner(files, native, assets);
            await assert.rejects(loadProjection(decisions, {assetProjectionId: selection.id, resourcePaths: selection.mapping ?? resourcePaths}), {code: selection.code});
            await decisions.unload();
            assert.equal(native.calls.load.length, 0);
            assert.equal(assets.calls.prepare.length, 0);
            assert.equal(assets.calls.release.length, 0);
            if (assets.records.has(selection.id)) {
                assert.equal(assets.records.get(selection.id).uses, 0);
                assert.equal(assets.records.get(selection.id).preparationOwned, true);
            }
        }
    });

    test(`${route} cancellation retains supplied files until actual native exit`, async function cancelledProjection(t) {
        const files = await fixture(t);
        const runGate = files.gate();
        const exitGate = files.gate();
        const assets = fakeAssets(files, [{id: 'cancelled-moon'}]);
        const native = fakeONNX({runGate, exitGate});
        const decisions = projectedOwner(files, native, assets);
        await loadProjection(decisions, {assetProjectionId: 'cancelled-moon', resourcePaths});
        await assets.owner.release('cancelled-moon');
        const cancellation = new AbortController();
        const reason = new Error('The entire moon request was cancelled.\nOriginal reason.');
        const evaluating = decisions.evaluate(rows, {signal: cancellation.signal});
        const rejected = assert.rejects(evaluating, function actualReason(error) { return error === reason; });
        const request = await native.runStarted.promise;
        cancellation.abort(reason);
        await native.unloadStarted.promise;
        await rejected;
        assert.equal(request.signal.aborted, true);
        assert.equal(assets.records.get('cancelled-moon').uses, 1);
        assert.equal(assets.records.get('cancelled-moon').state, 'ready');
        const releasing = decisions.unload();
        exitGate.resolve();
        await releasing;
        assert.equal(assets.records.get('cancelled-moon').uses, 0);
        assert.equal(assets.records.get('cancelled-moon').state, 'released');
        assert.equal(assets.calls.prepare.length, 0);
    });

    test(`${route} lifecycle preserves provisional release failures after the load has settled`, async function failedProvisionalRelease(t) {
        const files = await fixture(t);
        const native = fakeONNX();
        const assets = fakeAssets(files, [{id: 'cleanup-moon'}]);
        const error = new Error('The unused projection could not be removed.\nComplete cleanup failure.');
        error.code = 'FIXTURE_PROJECTION_RELEASE_FAILED';
        function actualCleanupFailure(failure) {
            assert.ok(failure instanceof AggregateError);
            assert.ok(failure.errors.includes(error));
            return true;
        }
        const decisions = route === 'direct'
            ? createNativeDecisionModel({onnx: native.owner, modelAssets: assets.owner})
            : createNativeDecisionService({}, {appRoot: files.root});
        if (route === 'Core') decisions.start({
            getService(name) { return name === 'local-ai' ? {getONNXRuntime() { return native.owner; }} : assets.owner; },
            emit() {}
        });
        files.own({async dispose() { await assert.rejects(decisions.dispose(), actualCleanupFailure); }});
        const retain = assets.owner.retain;
        let rejectedUnload;
        let releasedPreparation;
        assets.owner.retain = function cancelBeforeWorkerOwnership(id) {
            const use = retain(id);
            releasedPreparation = assets.owner.release(id);
            rejectedUnload = assert.rejects(decisions.unload(), actualCleanupFailure);
            return {...use, async release() {
                await use.release();
                assets.records.get(id).state = 'error';
                throw error;
            }};
        };
        await assert.rejects(loadProjection(decisions, {assetProjectionId: 'cleanup-moon', resourcePaths}), function originalCleanupError(failure) {
            return failure === error;
        });
        await Promise.all([rejectedUnload, releasedPreparation]);
        assert.equal(native.calls.load.length, 0);
        assert.equal(assets.calls.prepare.length, 0);
        assert.deepEqual(assets.calls.releaseRetain, ['cleanup-moon']);
        await assert.rejects(decisions.unload(), actualCleanupFailure);
        await assert.rejects(decisions.dispose(), actualCleanupFailure);
    });
}

for (const route of ['direct', 'Core']) {
    test(`${route} decisions retain the selected target, distinguish automatic selection and coalesce equal targets`, async function selectedDecisionTarget(t) {
        const files = await fixture(t);
        const native = fakeONNX();
        const assets = fakeAssets(files);
        const executionTarget = {deviceId: 'fixture-moon-adapter'};
        const sessionOptions = {graphOptimizationLevel: 'all'};
        const configuration = {executionTarget, sessionOptions, workingDirectory: 'model-working'};
        const decisions = files.own(route === 'direct'
            ? createNativeDecisionModel({...configuration, onnx: native.owner, modelAssets: assets.owner})
            : createNativeDecisionService(configuration, {appRoot: files.root}));
        if (route === 'Core') decisions.start({
            getService(name) {
                return name === 'local-ai' ? {getONNXRuntime() { return native.owner; }} : assets.owner;
            },
            emit() {}
        });
        const first = decisions.load();
        const same = decisions.load({executionTarget: {deviceId: executionTarget.deviceId}});
        await Promise.all([first, same]);
        assert.equal(native.calls.load.length, 1);
        assert.equal(assets.calls.prepare.length, 1);
        assert.equal(native.calls.load[0].executionTarget, executionTarget);
        assert.equal(native.calls.load[0].sessionOptions, sessionOptions);
        assert.equal(decisions.current().execution.execution.requestedTarget, executionTarget);
        assert.equal(decisions.current().execution.execution.observedTarget, null);
        assert.equal(decisions.current().pendingActivation, null);
        const automatic = route === 'Core'
            ? decisions.methods['decisions.load']({executionTarget: null}, {signal: t.signal})
            : decisions.load({executionTarget: null});
        await automatic;
        assert.equal(native.calls.load.length, 2);
        assert.equal(native.calls.load[1].executionTarget, null);
        assert.equal(native.calls.load[1].sessionOptions, sessionOptions);
        const automaticId = decisions.current().execution.id;
        await decisions.load({executionTarget: undefined});
        assert.equal(native.calls.load.length, 2);
        assert.equal(decisions.current().execution.id, automaticId);
        await decisions.unload();
        await decisions.load();
        assert.equal(native.calls.load.length, 3);
        assert.equal(native.calls.load[2].executionTarget, null);
        assert.equal(native.calls.load[2].sessionOptions, sessionOptions);
        assert.equal(decisions.current().pendingActivation, null);
    });

    test(`${route} target replacement cancels prior work and joins actual exit before the latest target activates`, async function replaceDecisionTarget(t) {
        const files = await fixture(t);
        const runGate = files.gate();
        const exitGate = files.gate();
        const assets = fakeAssets(files);
        const native = fakeONNX({runGate, exitGate, beforeLoad() {
            for (const previous of native.owner.current().sessions) {
                assert.equal(previous.exited, true, 'A successor may load only after the prior native exit.');
                assert.equal(assets.records.get(previous.id).retained, false, 'The prior working projection must finish releasing first.');
            }
        }});
        const firstTarget = {deviceId: 'fixture-first-adapter'};
        const intermediateTarget = {deviceId: 'fixture-intermediate-adapter'};
        const finalTarget = {deviceId: 'fixture-final-adapter'};
        const configuration = {executionTarget: firstTarget, workingDirectory: 'model-working'};
        const decisions = files.own(route === 'direct'
            ? createNativeDecisionModel({...configuration, onnx: native.owner, modelAssets: assets.owner})
            : createNativeDecisionService(configuration, {appRoot: files.root}));
        if (route === 'Core') decisions.start({
            getService(name) {
                return name === 'local-ai' ? {getONNXRuntime() { return native.owner; }} : assets.owner;
            },
            emit() {}
        });
        await decisions.load();
        const firstExecution = decisions.current().execution;
        const evaluating = decisions.evaluate(rows);
        const rejectedEvaluation = assert.rejects(evaluating, {code: 'ARCANE_AI_REQUEST_ABORTED'});
        const run = await native.runStarted.promise;
        const intermediate = decisions.load({executionTarget: intermediateTarget});
        const rejectedIntermediate = assert.rejects(intermediate, {code: 'ARCANE_AI_REQUEST_ABORTED'});
        assert.equal(decisions.current().execution, firstExecution);
        assert.deepEqual(decisions.current().pendingActivation, {executionTarget: intermediateTarget});
        await native.unloadStarted.promise;
        await rejectedEvaluation;
        assert.equal(run.signal.aborted, true);
        assert.equal(decisions.current().loaded, false);
        assert.equal(decisions.current().execution, firstExecution);
        assert.equal(firstExecution.execution.requestedTarget, firstTarget);
        assert.equal(firstExecution.loaded, true);
        assert.equal(firstExecution.exited, false);
        assert.equal(assets.records.get(firstExecution.id).retained, true);
        assert.equal(assets.calls.releaseRetain.length, 0);
        const final = decisions.load({executionTarget: finalTarget});
        assert.deepEqual(decisions.current().pendingActivation, {executionTarget: finalTarget});
        assert.equal(decisions.current().execution, firstExecution);
        assert.equal(native.calls.load.length, 1);
        assert.equal(assets.calls.prepare.length, 1);
        exitGate.resolve();
        const [, completed] = await Promise.all([rejectedIntermediate, final]);
        assert.equal(firstExecution.exited, true);
        assert.equal(assets.records.get(firstExecution.id).retained, false);
        assert.deepEqual(assets.calls.releaseRetain, [firstExecution.id]);
        assert.equal(native.calls.load.length, 2);
        assert.equal(native.calls.load[1].executionTarget, finalTarget);
        assert.equal(assets.calls.prepare.length, 2);
        assert.equal(completed.execution.id, native.calls.load[1].id);
        assert.equal(completed.execution.execution.requestedTarget, finalTarget);
        assert.equal(completed.loaded, true);
        assert.equal(completed.pendingActivation, null);
        assert.notEqual(completed.execution, firstExecution);
    });

    test(`${route} ready-state replacement cannot return the replaced target as a successful load`, async function reentrantDecisionTarget(t) {
        const files = await fixture(t);
        const native = fakeONNX();
        const firstTarget = {deviceId: 'fixture-first-adapter'};
        const replacementTarget = {deviceId: 'fixture-replacement-adapter'};
        const configuration = {executionTarget: firstTarget, paths: files.paths};
        const decisions = files.own(route === 'direct'
            ? createNativeDecisionModel({...configuration, onnx: native.owner})
            : createNativeDecisionService(configuration, {appRoot: files.root}));
        if (route === 'Core') decisions.start({
            getService(name) {
                assert.equal(name, 'local-ai');
                return {getONNXRuntime() { return native.owner; }};
            },
            emit() {}
        });
        let replacing = false;
        let replacement;
        const stop = decisions.subscribe(function replaceAtReady(snapshot) {
            if (!replacing && snapshot.loaded) {
                replacing = true;
                replacement = decisions.load({executionTarget: replacementTarget});
            }
        });
        await assert.rejects(decisions.load(), {code: 'ARCANE_AI_REQUEST_ABORTED'});
        assert.ok(replacement);
        const completed = await replacement;
        assert.equal(native.calls.load.length, 2);
        assert.equal(native.calls.unload[0].id, native.calls.load[0].id);
        assert.equal(completed.execution.id, native.calls.load[1].id);
        assert.equal(completed.execution.execution.requestedTarget, replacementTarget);
        assert.equal(completed.pendingActivation, null);
        stop();
    });
}

test('disposal revokes readiness synchronously and retains files until the native exit joins', async function retainUntilNativeExit(t) {
    const files = await fixture(t);
    const runGate = files.gate();
    const exitGate = files.gate();
    const native = fakeONNX({runGate, exitGate});
    const assets = fakeAssets(files);
    const model = files.own(createNativeDecisionModel({onnx: native.owner, modelAssets: assets.owner, workingDirectory: 'model-working'}));
    await model.load();
    const evaluating = model.evaluate(rows);
    const rejected = assert.rejects(evaluating, {code: 'ARCANE_AI_REQUEST_ABORTED'});
    const request = await native.runStarted.promise;
    const disposing = model.dispose();
    assert.equal(model.current().loaded, false);
    assert.equal(model.current().state, 'disposing');
    assert.equal(request.signal.aborted, true);
    await native.unloadStarted.promise;
    await rejected;
    assert.equal(assets.calls.release.length, 1, 'Preparation ownership was released after retain.');
    assert.equal(assets.calls.releaseRetain.length, 0, 'Operation rejection alone does not release native files.');
    assert.equal(assets.records.get(native.calls.load[0].id).retained, true);
    exitGate.resolve();
    await disposing;
    assert.equal(assets.calls.releaseRetain.length, 1);
    assert.equal(assets.records.get(native.calls.load[0].id).retained, false);
    assert.equal(model.current().state, 'disposed');
});

test('failure before ONNX session creation releases prepared assets without unloading a nonexistent session', async function failedBeforeSession(t) {
    const files = await fixture(t);
    const error = Object.assign(new Error('The native owner closed before loading.\nComplete failure.'), {code: 'LOCAL_AI_RUNTIME_CLOSED'});
    const native = fakeONNX({loadError: error});
    const assets = fakeAssets(files);
    const model = files.own(createNativeDecisionModel({onnx: native.owner, modelAssets: assets.owner, workingDirectory: 'model-working'}));
    await assert.rejects(model.load(), function actualError(value) { return value === error; });
    await model.unload();
    assert.deepEqual(native.owner.current().sessions, []);
    assert.equal(native.calls.unload.length, 0);
    assert.equal(assets.calls.release.length, 1);
    assert.equal(assets.calls.releaseRetain.length, 1);
    assert.equal(model.current().state, 'error');
    assert.equal(model.current().error.message, error.message);
});

test('an unload error preserves its actual failure while proven native exit permits retained-file release', async function failedUnloadAfterExit(t) {
    const files = await fixture(t);
    const error = Object.assign(new Error('Complete native release failure.\nThe worker already exited.'), {code: 'FIXTURE_RELEASE_FAILED'});
    const native = fakeONNX({unloadError: error});
    const assets = fakeAssets(files);
    const model = createNativeDecisionModel({onnx: native.owner, modelAssets: assets.owner, workingDirectory: 'model-working'});
    function actualReleaseFailure(failure) {
        assert.ok(failure instanceof AggregateError);
        assert.ok(failure.errors.includes(error));
        return true;
    }
    files.own({async dispose() {
        await assert.rejects(model.dispose(), actualReleaseFailure);
    }});
    await model.load();
    await assert.rejects(model.unload(), actualReleaseFailure);
    assert.equal(native.owner.current().sessions[0].exited, true);
    assert.equal(model.current().state, 'error');
    assert.equal(model.current().loaded, false);
    assert.equal(model.current().error.errors[0].message, error.message);
    assert.equal(assets.calls.releaseRetain.length, 1);
    assert.equal(assets.records.get(native.calls.load[0].id).retained, false);
});

test('reentrant final readiness publication cannot commit a retired decision result', async function finalNotificationCancellation(t) {
    const files = await fixture(t);
    const native = fakeONNX();
    const model = files.own(createNativeDecisionModel({onnx: native.owner, paths: files.paths}));
    await model.load();
    let accepted = false;
    let release;
    const stop = model.subscribe(function cancelAtFinalState(snapshot) {
        if (snapshot.activeRequests) accepted = true;
        if (accepted && !release && snapshot.loaded && snapshot.activeRequests === 0 && snapshot.progress?.phase === 'ready') {
            release = model.unload();
        }
    });
    await assert.rejects(model.evaluate(rows), {code: 'ARCANE_AI_REQUEST_ABORTED'});
    assert.ok(release);
    await release;
    assert.equal(model.current().loaded, false);
    stop();
});

test('ordinary row errors keep the tokenizer and native activation usable', async function invalidRowsRemainOrdinary(t) {
    const files = await fixture(t);
    const native = fakeONNX();
    const model = files.own(createNativeDecisionModel({onnx: native.owner, paths: files.paths}));
    await model.load();
    await assert.rejects(model.evaluate([{state: originalState, question: 'Keep the moon?', options: []}]), {
        name: 'TypeError', message: 'A decision row requires string state/question and string options.'
    });
    assert.equal(model.current().state, 'ready');
    assert.equal(model.current().loaded, true);
    assert.equal(native.calls.run.length, 0);
    assert.equal(native.calls.unload.length, 0);
    const result = await model.evaluate(rows);
    assert.equal(result.decisions[0].row.state, originalState);
    assert.equal(native.calls.load.length, 1);
    assert.equal(native.calls.run.length, 1);
});

test(
    'a recoverable ONNX run error preserves its original error, sibling jobs and the loaded activation',
    async function recoverableNativeRunError(t) {
        const files = await fixture(t);
        const runGate = files.gate();
        const error = new Error('The moon graph rejected this row.\nComplete native run diagnostic: 雪 🐙.');
        error.code = 'FIXTURE_ROW_REJECTED';
        error.details = {state: originalState, question: rows[0].question};
        const native = fakeONNX(
            {runError: error, runGate}
        );
        const model = files.own(
            createNativeDecisionModel(
                {onnx: native.owner, paths: files.paths}
            )
        );
        const snapshots = [];
        const stop = model.subscribe(
            function observeRecoverableError(snapshot) {
                snapshots.push(snapshot);
            }
        );
        await model.load();
        const evaluating = model.evaluate(rows);
        const rejected = assert.rejects(
            evaluating,
            function preserveOriginalRunError(value) {
                assert.equal(value, error);
                assert.equal(value.message, error.message);
                assert.equal(value.details.state, originalState);
                return true;
            }
        );
        await native.runStarted.promise;
        const sibling = model.evaluate(rows);
        assert.equal(model.current().activeRequests, 2);
        const completed = Promise.all(
            [rejected, sibling]
        );
        runGate.resolve();
        const [, result] = await completed;
        assert.equal(result.outputs, native.outputs);
        assert.equal(result.decisions[0].row, rows[0]);
        assert.equal(native.calls.load.length, 1);
        assert.equal(native.calls.unload.length, 0);
        assert.equal(native.calls.load[0].signal.aborted, false);
        assert.equal(native.owner.current().sessions[0].stopping, false);
        assert.equal(model.current().loaded, true);
        assert.equal(model.current().state, 'ready');
        assert.equal(model.current().activeRequests, 0);
        const failedRow = snapshots.find(
            function completeLoadedRunFailure(snapshot) {
                return snapshot.loaded && snapshot.error?.message === error.message;
            }
        );
        assert.ok(failedRow);
        assert.deepEqual(failedRow.error.details, error.details);
        const later = await model.evaluate(rows);
        assert.equal(later.outputs, native.outputs);
        assert.equal(native.calls.run.length, 3);
        assert.equal(native.calls.load.length, 1);
        assert.equal(native.calls.unload.length, 0);
        stop();
    }
);

test(
    'terminal ONNX stopping revokes readiness while retaining physically loaded files until exit',
    async function terminalNativeStopping(t) {
        const files = await fixture(t);
        const exitGate = files.gate();
        const native = fakeONNX(
            {exitGate}
        );
        const assets = fakeAssets(files);
        const model = files.own(
            createNativeDecisionModel(
                {onnx: native.owner, modelAssets: assets.owner, workingDirectory: 'model-working'}
            )
        );
        await model.load();
        const error = new Error('The native worker failed.\nComplete terminal diagnostic.');
        error.code = 'FIXTURE_WORKER_FAILED';
        native.failWorker(error);
        assert.equal(model.current().loaded, false);
        assert.equal(model.current().state, 'unloading');
        assert.equal(model.current().error.message, error.message);
        assert.equal(model.current().error.code, error.code);
        assert.equal(native.owner.current().sessions[0].stopping, true);
        assert.equal(native.owner.current().sessions[0].loaded, true);
        assert.equal(native.owner.current().sessions[0].exited, false);
        await native.unloadStarted.promise;
        assert.equal(assets.calls.releaseRetain.length, 0);
        assert.equal(assets.records.get(native.calls.load[0].id).retained, true);
        const released = model.unload();
        exitGate.resolve();
        await released;
        assert.equal(native.owner.current().sessions[0].exited, true);
        assert.equal(native.owner.current().sessions[0].loaded, false);
        assert.equal(assets.calls.releaseRetain.length, 1);
        assert.equal(model.current().state, 'error');
        assert.equal(model.current().error.message, error.message);
    }
);

test('terminal tokenizer initialization failure is observable and retires native ownership', async function terminalTokenizerFailure(t) {
    const files = await fixture(t, {invalidTokenizer: true});
    const errors = [];
    const tokenizer = files.own(createDecisionTokenizer({
        tokenizerPath: files.paths.tokenizer, tokenizerConfigPath: files.paths.tokenizerConfig,
        onError(error) { errors.push(error); }
    }));
    await assert.rejects(tokenizer.ready, function originalTokenizerError(error) {
        assert.equal(error.name, 'SyntaxError');
        assert.equal(errors[0], error);
        return true;
    });
    await tokenizer.close();
    assert.equal(errors.length, 1);
    const native = fakeONNX();
    const model = files.own(createNativeDecisionModel({onnx: native.owner, paths: files.paths}));
    await assert.rejects(model.load(), {name: 'SyntaxError'});
    await model.unload();
    assert.equal(model.current().loaded, false);
    assert.equal(model.current().state, 'error');
    assert.equal(model.current().error.name, 'SyntaxError');
    assert.equal(native.calls.unload.length, 1);
});
